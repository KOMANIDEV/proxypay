# Architecture Overview

This backend bridges mobile money providers with Stellar via REST/GraphQL APIs backed by PostgreSQL, Redis, and BullMQ for processing.

## Component Interaction

```mermaid
flowchart LR
  Client --> API[Express API]
  API --> Routes[Routes & Middleware]
  Routes --> Controllers[Controllers]
  Controllers --> Services[Domain Services]
  Services --> Postgres[(PostgreSQL)]
  Services --> Redis[(Redis)]
  Services --> Bull["BullMQ Queues"]
  Services --> Stellar[Stellar Network]
  Services --> Mobile[Mobile Money Providers]
  Services --> S3[S3/File Storage]
```

## Transaction State Machine

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Processing
  Processing --> Completed
  Processing --> Failed
  Processing --> Cancelled
```

## Key Entities

```mermaid
erDiagram
  USERS {
    string id PK
  }
  TRANSACTIONS {
    string id PK
    string user_id FK
    string status
  }
  KYC_APPLICANTS {
    string id PK
    string user_id FK
    string status
  }
  USERS ||--o{ TRANSACTIONS : owns
  USERS ||--o{ KYC_APPLICANTS : owns
```

