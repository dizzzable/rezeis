-- CreateTable
CREATE TABLE "admin_notification_preferences" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_notification_preferences_admin_id_idx" ON "admin_notification_preferences"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_notification_preferences_admin_id_category_key" ON "admin_notification_preferences"("admin_id", "category");

-- AddForeignKey
ALTER TABLE "admin_notification_preferences" ADD CONSTRAINT "admin_notification_preferences_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
