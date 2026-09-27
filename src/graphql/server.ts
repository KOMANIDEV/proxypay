import type { Application, Request } from "express";
import { ApolloServer } from "apollo-server-express";
import {
  ApolloServerPluginLandingPageGraphQLPlayground,
  ApolloServerPluginLandingPageProductionDefault,
} from "apollo-server-core";
// @ts-expect-error ESM module
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer, type ServerCleanup } from "graphql-ws/use/ws";
import { typeDefs } from "./schema";
import { resolvers, subscriptionResolvers } from "./resolvers";
import { buildGraphqlContext } from "./context";
import { Server } from "http";
import depthLimit from "graphql-depth-limit";
import {
  createComplexityRule,
  simpleEstimator,
  fieldExtensionsEstimator,
} from "graphql-query-complexity";
import { createAPQCache } from "./apqCache";
import { authenticateWsConnection } from "./wsAuth";

// Merge resolvers with subscription resolvers
const mergedResolvers = {
  ...resolvers,
  ...subscriptionResolvers,
};

export async function startApolloServer(
  app: Application,
  httpServer: Server,
): Promise<ServerCleanup | null> {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: mergedResolvers,
  });

  // APQ cache — Redis-backed, degrades gracefully on Redis downtime
  const apqCache = createAPQCache();

  const server = new ApolloServer({
    schema,
    context: ({ req }: { req: Request }) => buildGraphqlContext(req),

    // ---------------------------------------------------------------------------
    // Automatic Persisted Queries (APQ)
    // Clients send a SHA-256 hash of the query instead of the full string.
    // On cache miss Apollo returns PersistedQueryNotFound; the client retries
    // with the full query + hash, which is then stored in Redis for future hits.
    // ---------------------------------------------------------------------------
    persistedQueries: {
      cache: apqCache,
      // ttl is managed by the cache adapter itself (APQ_TTL_SECONDS env var)
    },

    validationRules: [
      depthLimit(5),
        // Enforce strict query complexity limit of 500 points per request
      createComplexityRule({
        maximumComplexity: 500,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      }),
    ],
    plugins: [
      process.env.NODE_ENV === "production"
        ? ApolloServerPluginLandingPageProductionDefault({ footer: false })
        : ApolloServerPluginLandingPageGraphQLPlayground(),
      // Plugin for proper shutdown of WebSocket server
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
  });

  await server.start();
  // apollo-server-express bundles its own @types/express; cast avoids duplicate-type errors.
  server.applyMiddleware({ app: app as never, path: "/graphql", cors: false });

  // Create the WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  // Isolate transport-level failures so one bad client cannot take down WS
  wsServer.on("error", (err) => {
    console.error("[WS] WebSocketServer error (non-fatal):", err);
  });
  wsServer.on("connection", (socket) => {
    socket.on("error", (err) => {
      console.error("[WS] client socket error (non-fatal):", err.message);
    });
  });

  // Set up the graphql-ws server
  const serverCleanup = useServer(
    {
      schema,
      context: (ctx: any) => {
        const jwtClaims = ctx.extra?.jwtClaims;
        try {
          const req = ctx.extra.request as Request | undefined;
          // Build base context from HTTP request, then overlay WS JWT auth
          const base = buildGraphqlContext(req as Request);
          if (jwtClaims) {
            base.auth = {
              authenticated: true,
              subject: jwtClaims.userId ?? null,
            };
          }
          return base;
        } catch (err) {
          // HTTP API-key checks may fail on the WS upgrade request; JWT still wins
          if (jwtClaims) {
            return {
              auth: {
                authenticated: true,
                subject: jwtClaims.userId ?? null,
              },
            };
          }
          console.error("[WS] context build failed (non-fatal):", err);
          return {
            auth: { authenticated: false, subject: null },
          };
        }
      },
      onConnect: (ctx: any) => {
        // JWT via connectionParams; never throw — return false to close this socket only
        const result = authenticateWsConnection(ctx.connectionParams);
        if (!result.ok) {
          console.warn(`[WS] Rejected connection — ${result.reason}`);
          return false;
        }
        if (result.claims) {
          ctx.extra.jwtClaims = result.claims;
          console.log(
            `[WS] Authenticated connection for user ${result.claims.userId}`,
          );
        }
        return true;
      },
      onSubscribe: (_ctx: any, message: any) => {
        try {
          // Validate payload shape lightly; never throw out of this hook
          if (!message?.payload?.query) {
            console.warn("[WS] onSubscribe missing query payload");
          }
        } catch (err) {
          console.error("[WS] onSubscribe error (non-fatal):", err);
        }
      },
      onDisconnect: (_ctx: any) => {
        console.log("WebSocket subscription disconnected");
      },
      onError: (_ctx: any, _message: any, errors: any) => {
        // Log connection/subscription errors without rethrowing
        console.error("[WS] subscription error (non-fatal):", errors);
      },
    },
    wsServer,
  );

  return serverCleanup;
}
