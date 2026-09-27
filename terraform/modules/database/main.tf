# ──────────────────────────────────────────────────────────────────────────────
# Database Module – RDS PostgreSQL 16
# Managed PostgreSQL instance matching the project's existing Postgres 16 usage.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-db-subnet"
    Environment = var.environment
  }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project}-${var.environment}-pg16-params"
  family = "postgres16"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-pg-params"
    Environment = var.environment
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.project}-${var.environment}-postgres"

  # Engine
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.postgres.name

  # Storage
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = 5432

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  # Backup & Maintenance
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"

  # Lifecycle
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${var.project}-${var.environment}-final-snapshot" : null
  deletion_protection       = var.environment == "production"

  tags = {
    Name        = "${var.project}-${var.environment}-postgres"
    Environment = var.environment
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# Cross-Region Replication (DR)
#
# When `enable_cross_region_replica` is true, a second provider (aws.dr) is used
# to provision a minimal VPC + subnet group + security group in the DR region
# and a read replica of the primary instance via `replicate_source_db`. The app
# reads from it through READ_REPLICA_URL and, after a promoted-replica failover,
# writes through DR_DATABASE_URL (see docs/runbooks/11-database-failover.md).
# ──────────────────────────────────────────────────────────────────────────────

data "aws_availability_zones" "dr" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? 1 : 0
  state    = "available"
}

locals {
  dr_azs = var.enable_cross_region_replica
    ? slice(data.aws_availability_zones.dr[0].names, 0, var.dr_az_count)
    : []
}

resource "aws_vpc" "dr" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? 1 : 0

  cidr_block           = var.dr_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${var.project}-${var.environment}-dr-vpc"
    Environment = var.environment
    Tier        = "dr"
  }
}

resource "aws_subnet" "dr" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? var.dr_az_count : 0

  vpc_id            = aws_vpc.dr[0].id
  cidr_block        = cidrsubnet(var.dr_vpc_cidr, 8, count.index + 1)
  availability_zone = local.dr_azs[count.index]

  tags = {
    Name        = "${var.project}-${var.environment}-dr-subnet-${local.dr_azs[count.index]}"
    Environment = var.environment
    Tier        = "dr"
  }
}

resource "aws_db_subnet_group" "dr" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? 1 : 0

  name       = "${var.project}-${var.environment}-dr-db-subnet"
  subnet_ids = aws_subnet.dr[*].id

  tags = {
    Name        = "${var.project}-${var.environment}-dr-db-subnet"
    Environment = var.environment
  }
}

resource "aws_security_group" "dr" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? 1 : 0

  name        = "${var.project}-${var.environment}-dr-db-sg"
  description = "Allow PostgreSQL access to the DR replica from primary and DR VPCs"
  vpc_id      = aws_vpc.dr[0].id

  ingress {
    description = "PostgreSQL from primary region VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.primary_vpc_cidr]
  }

  ingress {
    description = "PostgreSQL from DR region VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.dr_vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project}-${var.environment}-dr-db-sg"
    Environment = var.environment
  }
}

resource "aws_db_instance" "dr_replica" {
  provider = aws.dr
  count    = var.enable_cross_region_replica ? 1 : 0

  identifier = "${var.project}-${var.environment}-postgres-dr"

  # Cross-region read replica of the primary instance
  replicate_source_db = aws_db_instance.main.arn
  instance_class      = var.dr_db_instance_class

  # Storage
  allocated_storage = var.dr_db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  # Network
  db_subnet_group_name   = aws_db_subnet_group.dr[0].name
  vpc_security_group_ids = [aws_security_group.dr[0].id]
  publicly_accessible    = false

  # Backup & maintenance (RDS cross-region replicas require backups enabled)
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:30-04:30"
  maintenance_window      = "sun:05:30-sun:06:30"

  # Replicas are created from a snapshot-like process; never destroy the DR
  # replica accidentally with a force-destroy.
  skip_final_snapshot = var.environment != "production"

  tags = {
    Name        = "${var.project}-${var.environment}-postgres-dr"
    Environment = var.environment
    Tier        = "dr"
  }
}
