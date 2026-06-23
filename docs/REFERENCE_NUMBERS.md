# Transaction Reference Numbers

## Overview

All transactions in the system are assigned a unique, human-readable reference number for easy identification, tracking, and customer support.

## Format

```
TXN-YYYYMMDD-XXXXX
```

### Components

- **Prefix**: `TXN` - Identifies this as a transaction reference
- **Date**: `YYYYMMDD` - Transaction creation date (enables chronological sorting)
- **Sequence**: `XXXXX` - 5-digit zero-padded sequential number (resets daily)

## Examples

```
TXN-20260322-00001  (First transaction on March 22, 2026)
TXN-20260322-00002  (Second transaction on March 22, 2026)
TXN-20260323-00001  (First transaction on March 23, 2026)
```

## Features

- **Unique**: Each reference number is guaranteed to be unique across all transactions
- **Sortable**: Date-based format allows natural chronological sorting
- **Searchable**: Indexed in database for fast lookups
- **Human-friendly**: Easy to read, communicate, and remember
- **Date-aware**: Quickly identify when a transaction occurred

## Usage

### Creating Transactions

Reference numbers are automatically generated when creating new transactions:

```typescript
const transaction = await transactionModel.create({
  type: "deposit",
  amount: "100.00",
  phoneNumber: "+1234567890",
  provider: "mtn",
  stellarAddress: "GXXX...",
  status: "pending",
});

console.log(transaction.referenceNumber); // TXN-20260322-00001
```

### Finding by Reference Number

```typescript
const transaction =
  await transactionModel.findByReferenceNumber("TXN-20260322-00001");
```

### Validation

```typescript
import { isValidReferenceNumber } from "../utils/referenceGenerator";

if (isValidReferenceNumber("TXN-20260322-00001")) {
  // Valid format
}
```

## Implementation Details

- Reference numbers are generated at the database level during transaction creation
- Sequence numbers increment per day and reset at midnight
- The generator queries the database to find the highest sequence for the current date
- Database constraint ensures uniqueness
- Indexed for optimal search performance

## Customer Support

Reference numbers should be:

- Displayed on all transaction receipts
- Included in confirmation messages
- Used for customer support inquiries
- Shown in transaction history

