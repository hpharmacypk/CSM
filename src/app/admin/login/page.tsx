import { LoginForm } from "./login-form";

export const metadata = { title: "Admin sign in · H-Pharmacy" };

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <LoginForm />
        <p className="mt-5 text-center text-xs text-muted">For H-Pharmacy staff only.</p>
      </div>
    </main>
  );
}
