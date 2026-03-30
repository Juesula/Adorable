import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const ACCOUNT_COOKIE = "adorable_account_id";

export async function GET() {
  const jar = await cookies();
  const accountId = jar.get(ACCOUNT_COOKIE)?.value ?? null;
  return NextResponse.json({ accountId });
}

export async function POST() {
  const jar = await cookies();
  const accountId = randomUUID();

  jar.set(ACCOUNT_COOKIE, accountId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({ accountId });
}
