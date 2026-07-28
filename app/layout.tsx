import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Newone Relay · Korean ↔ Spanish operations chat";
const description =
  "A bilingual operations messenger with inline Korean–Spanish translation, shift briefs, tasks, and searchable history.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "newone-relay.invalid";
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProto === "http" ? "http" : "https";
  let metadataBase: URL;
  try {
    metadataBase = new URL(`${protocol}://${host}`);
  } catch {
    metadataBase = new URL("https://newone-relay.invalid");
  }
  const shareImage = new URL("/newone-relay-og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    applicationName: "Newone Relay",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Relay",
    },
    openGraph: {
      type: "website",
      title,
      description,
      siteName: "Newone Relay",
      images: [{ url: shareImage, width: 1200, height: 630, alt: "Newone Relay: Every shift, understood." }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [shareImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#123f3a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
