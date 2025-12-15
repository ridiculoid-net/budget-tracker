import AuthGate from "@/components/AuthGate";

export default function Page() {
  return (
    <AuthGate>
      <main>
        Your page content
      </main>
    </AuthGate>
  );
}
