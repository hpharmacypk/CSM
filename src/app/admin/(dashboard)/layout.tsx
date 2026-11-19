import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getVerifiedAdminId } from "@/lib/supabase/admin-server-client";
import { AdminShell } from "./admin-shell";

export const metadata = { title: "Inbox · H-Pharmacy Admin" };

export default function AdminDashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted">
          Checking access…
        </div>
      }
    >
      <AdminGate>{children}</AdminGate>
    </Suspense>
  );
}

/**
 * Server-side gate: the request must carry a valid Supabase session for an
 * account listed in private.admins. The database enforces the same rule via
 * RLS, so this is defence in depth, not the only check.
 */
async function AdminGate({ children }: { children: ReactNode }) {
  // Always evaluate per request — never prerender an access decision.
  await connection();
  const adminId = await getVerifiedAdminId();
  if (!adminId) redirect("/admin/login");
  return <AdminShell>{children}</AdminShell>;
}
