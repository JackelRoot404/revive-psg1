ALTER TABLE "beta_invites" ALTER COLUMN "device_id" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX "beta_invites_device_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invites_device_uq" ON "beta_invites" USING btree ("device_id") WHERE "device_id" IS NOT NULL;
