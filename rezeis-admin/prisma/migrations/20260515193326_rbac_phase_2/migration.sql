-- RBAC Phase 2: custom roles, permission matrix, and scope policies.
--
-- Adds three tables (admin_roles, admin_permissions, admin_scope_policies)
-- plus an optional rbac_role_id pointer on admin_users. The legacy `role`
-- enum on admin_users is kept untouched for backwards compatibility.

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "rbac_role_id" TEXT;

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_scope_policies" (
    "id" TEXT NOT NULL,
    "role_id" TEXT,
    "admin_user_id" TEXT,
    "resource_type" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_value" TEXT NOT NULL,
    "actions" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_scope_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_name_key" ON "admin_roles"("name");

-- CreateIndex
CREATE INDEX "admin_permissions_role_id_idx" ON "admin_permissions"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_permissions_role_id_resource_action_key" ON "admin_permissions"("role_id", "resource", "action");

-- CreateIndex
CREATE INDEX "admin_scope_policies_role_id_idx" ON "admin_scope_policies"("role_id");

-- CreateIndex
CREATE INDEX "admin_scope_policies_admin_user_id_idx" ON "admin_scope_policies"("admin_user_id");

-- CreateIndex
CREATE INDEX "admin_scope_policies_resource_type_idx" ON "admin_scope_policies"("resource_type");

-- CreateIndex
CREATE INDEX "admin_users_rbac_role_id_idx" ON "admin_users"("rbac_role_id");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_rbac_role_id_fkey" FOREIGN KEY ("rbac_role_id") REFERENCES "admin_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_scope_policies" ADD CONSTRAINT "admin_scope_policies_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
