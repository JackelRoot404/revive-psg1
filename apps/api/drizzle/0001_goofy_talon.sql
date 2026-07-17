CREATE TABLE "launch_gate_checks" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_by" varchar(120),
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
