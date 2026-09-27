import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    jwtUser?: { userId?: string; role?: string };
    user?: { id?: string; role?: string };
    isNewDevice?: boolean;
    requiresAdditionalVerification?: boolean;
    twoFactorVerified?: boolean;
    clientIp?: string;
    geoLocation?: unknown;
    userRole?: string;
  }
}
