# Mobile Money – Terraform Infrastructure

Infrastructure as Code for provisioning the Mobile Money platform on AWS.

## Architecture

```
Internet → ALB (public subnets) → ECS Fargate (private subnets) → RDS PostgreSQL 16
                                                                  → ElastiCache Redis 7
```

## Modules

| Module | Purpose |
|--------|---------|
| `modules/vpc` | VPC, public/private subnets, IGW, NAT, route tables |
| `modules/security` | Security groups for ALB, app, database, Redis |
| `modules/database` | RDS PostgreSQL 16 with encryption and automated backups; optional cross-region read replica (DR) |
| `modules/redis` | ElastiCache Redis 7 replication group |
| `modules/web` | ALB + ECS Fargate cluster with auto-scaling |

## Cross-Region Replication (DR)

Set `enable_cross_region_replica = true` to provision a warm read replica of
RDS in `dr_region` (default `us-west-2`) for disaster recovery. The replica is
created via `replicate_source_db` using a second provider alias (`aws.dr`).

```bash
terraform apply -var-file="environments/production.tfvars"
terraform output dr_db_endpoint
terraform output dr_db_connection_url
```

Point the app's `READ_REPLICA_URL` at the replica. Failover/promotion
procedures are in `../docs/runbooks/11-database-failover.md`.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- AWS CLI configured with appropriate credentials
- Remote backend configured in `terraform/main.tf` using S3 + DynamoDB locking

## Quick Start

```bash
cd terraform

# 1. Copy and fill in your secrets
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your db_password and other values

# 2. Initialize Terraform
terraform init

# 3. Preview changes
terraform plan -var-file="environments/staging.tfvars"

# 4. Apply
terraform apply -var-file="environments/staging.tfvars"
```

## Environments

Deploy identical stacks with different sizing:

```bash
# Staging — lean, single-AZ, minimal replicas
terraform apply -var-file="environments/staging.tfvars"

# Production — Multi-AZ database, Redis failover, more capacity
terraform apply -var-file="environments/production.tfvars"
```

## Key Outputs

After `terraform apply`, these values are available:

| Output | Description |
|--------|-------------|
| `alb_dns_name` | ALB DNS — point your domain here |
| `db_endpoint` | RDS PostgreSQL host:port |
| `dr_db_endpoint` | Cross-region replica host:port (empty when disabled) |
| `dr_db_arn` | ARN of the cross-region replica (promotion target) |
| `redis_endpoint` | ElastiCache primary endpoint |
| `ecs_cluster_name` | ECS cluster name |

```bash
terraform output alb_dns_name
terraform output db_endpoint
```

## Destroying Infrastructure

```bash
terraform destroy -var-file="environments/staging.tfvars"
```

> **Note**: Production RDS has `deletion_protection = true`. Disable it in the console before destroying.
