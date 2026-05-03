import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "Automatic orphan connection is disabled. Use evidence-backed remap or manual curation instead.",
      newRelations: 0,
    },
    { status: 422 }
  );
}
