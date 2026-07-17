ALTER TABLE "sessions" ADD COLUMN "request_nonce_hash" varchar(64);--> statement-breakpoint
UPDATE "sessions" SET "request_nonce_hash" = md5("id"::text) || md5('legacy:' || "id"::text) WHERE "request_nonce_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "request_nonce_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_request_nonce_uq" ON "sessions" USING btree ("request_nonce_hash");
