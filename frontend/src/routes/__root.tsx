import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { AuthProvider } from "@/lib/auth";
import appCss from "../styles.css?url";

// Initialize i18n
import "../lib/i18n";
import { I18nextProvider } from "react-i18next";
import i18n from "../lib/i18n";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5">
      <div className="ink-card-lg w-full max-w-[560px] px-[30px] py-[32px] text-center">
        <p className="numeral text-[86px]">404</p>
        <span className="swoosh mx-auto mt-1" aria-hidden="true" />
        <h1 className="mt-6 font-display text-[31px] font-normal text-ink">Siden finnes ikke</h1>
        <p className="mx-auto mt-3 max-w-[420px] font-body text-[17px] font-light text-ink">
          Adressen du kom fra peker ikke lenger til noe. Sjekk lenken, eller gå tilbake til
          forsiden.
        </p>
        <Link to="/" className="btn-ink mt-8 px-[26px] py-[15px] text-[16px]">
          Til forsiden
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5">
      <div className="ink-card-lg w-full max-w-[560px] px-[30px] py-[32px] text-center">
        <h1 className="font-display text-[31px] font-bold text-ink">Denne siden lastet ikke</h1>
        <span className="swoosh mx-auto mt-2" aria-hidden="true" />
        <p className="mx-auto mt-4 max-w-[420px] font-body text-[17px] font-light text-ink">
          Noe gikk galt hos oss. Prøv å laste inn på nytt, eller gå tilbake til forsiden.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="btn-ink px-[26px] py-[15px] text-[16px]"
          >
            Prøv igjen
          </button>
          <a href="/" className="btn-outline px-[26px] py-[15px] text-[16px]">
            Til forsiden
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Snoat" },
      {
        name: "description",
        content: "Norsk skyinfrastruktur for moderne apper. Deploy på helnorsk infrastruktur.",
      },
      { name: "author", content: "Frostbyte Group AS" },
      { property: "og:title", content: "Snoat" },
      {
        property: "og:description",
        content: "Norsk skyinfrastruktur for moderne apper.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://api.fontshare.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://api.fontshare.com/v2/css?f%5B%5D=clash-display@200,300,400,500,600&display=swap",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang={i18n.language || "en"} suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          Innrullingsanimasjonen starter skjult (`[data-reveal]` i styles.css) og
          settes synlig av `Reveal` når elementet treffer skjermen. Uten
          JavaScript kommer den beskjeden aldri — derfor slår vi av
          starttilstanden helt i det tilfellet, så innholdet alltid vises.
        */}
        <noscript>
          <style>{`[data-reveal]{opacity:1!important;transform:none!important}`}</style>
        </noscript>
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Detekter språk i nettleseren KUN etter montering for å forhindre SSR hydration mismatch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("i18nextLng");
    const browserLang =
      navigator.language?.startsWith("no") ||
      navigator.language?.startsWith("nb") ||
      navigator.language?.startsWith("nn")
        ? "no"
        : "en";

    const targetLang = saved || browserLang;
    if (targetLang && i18n.language !== targetLang) {
      void i18n.changeLanguage(targetLang);
    }
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
