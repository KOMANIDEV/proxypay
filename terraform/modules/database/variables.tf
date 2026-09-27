variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the DB subnet group"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID for the database"
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage allocation in GB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Maximum autoscaling storage in GB"
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the default database"
  type        = string
  default     = "proxypay_stellar"
}

variable "db_username" {
  description = "Master database username"
  type        = string
  default     = "mobilemoney"
  sensitive   = true
}

variable "db_password" {
  description = "Master database password"
  type        = string
  sensitive   = true
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment"
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = 7
}

# ── Cross-Region Replication (DR) ──────────────────────────────────────────
variable "enable_cross_region_replica" {
  description = "Provision a read replica of the primary RDS instance in a second AWS region"
  type        = bool
  default     = false
}

variable "dr_region" {
  description = "AWS region for the cross-region read replica (DR region)"
  type        = string
  default     = "us-west-2"
}

variable "dr_vpc_cidr" {
  description = "CIDR block for the minimal DR-region VPC hosting the cross-region replica"
  type        = string
  default     = "10.1.0.0/16"
}

variable "dr_az_count" {
  description = "Number of availability zones for the DR-region subnet group"
  type        = number
  default     = 2
}

variable "primary_vpc_cidr" {
  description = "CIDR block of the primary-region VPC (allowed to reach the DR replica)"
  type        = string
  default     = "10.0.0.0/16"
}

variable "dr_db_instance_class" {
  description = "RDS instance class for the cross-region replica"
  type        = string
  default     = "db.t3.micro"
}

variable "dr_db_allocated_storage" {
  description = "Initial storage allocation in GB for the cross-region replica"
  type        = number
  default     = 20
}
