-- Rollback: 000_create_roles_and_permissions
-- Inverted from 000_create_roles_and_permissions.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
