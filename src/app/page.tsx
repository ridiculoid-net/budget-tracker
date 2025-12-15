import AuthGate from "../components/AuthGate";

export default function Page() {
  return (
    <AuthGate>
      <div>Hello from Page</div>
    </AuthGate>
  );
}
