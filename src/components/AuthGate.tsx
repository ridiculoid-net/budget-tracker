import AuthGate from "@/src/components/AuthGate";

export default function Page() {
  return (
    <AuthGate>
      <main style={{ padding: 24 }}>
        <h1>Home</h1>
        <p>It builds. It ships. It lives.</p>
      </main>
    </AuthGate>
  );
}
