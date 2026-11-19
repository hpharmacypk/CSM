import { LoginForm } from "./login-form";

export const metadata = { title: "Admin sign in · H-Pharmacy" };

export default function AdminLoginPage() {
  return (
    <main className="flex h-full items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
