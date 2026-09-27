# ──────────────────────────────────────────────────────────────────────────────
# Production Environment
# High-availability configuration with Multi-AZ database and Redis failover.
# ──────────────────────────────────────────────────────────────────────────────

environment = "production"

# Networking
vpc_cidr = "10.0.0.0/16"
az_count = 2

# Application — bigger tasks, more replicas
task_cpu      = 512
task_memory   = 1024
desired_count = 3
max_count     = 10

# Database — larger instance, Multi-AZ for HA
db_instance_class    = "db.t3.small"
db_allocated_storage = 50
db_multi_az          = true

# Cross-region replication — production keeps a warm read replica in us-west-2
# as the DR target. Promote it via the failover runbook when us-east-1 is lost.
enable_cross_region_replica = true
dr_region                   = "us-west-2"
dr_vpc_cidr                 = "10.1.0.0/16"
dr_az_count                 = 2
dr_db_instance_class        = "db.t3.small"
dr_db_allocated_storage     = 50

# Redis — 2 nodes for automatic failover
redis_node_type          = "cache.t3.small"
redis_num_cache_clusters = 2
