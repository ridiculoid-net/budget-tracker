import "./globals.css";

export const metadata = {
  title: "Budget Tracker",
  description: "Cyberpunk budget cockpit"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}