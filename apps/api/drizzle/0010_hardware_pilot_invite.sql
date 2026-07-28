ALTER TABLE "beta_invites" ADD COLUMN "kind" varchar(32) DEFAULT 'cohort' NOT NULL;
--> statement-breakpoint
ALTER TABLE "beta_invites" ADD CONSTRAINT "beta_invites_kind_check" CHECK ("kind" IN ('cohort', 'hardware_pilot'));
--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invites_hardware_pilot_once_uq" ON "beta_invites" USING btree ("kind") WHERE "kind" = 'hardware_pilot';
