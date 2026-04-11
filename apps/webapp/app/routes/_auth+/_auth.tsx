import { Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import { ShelfSymbolLogo } from "~/components/marketing/logos";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

export const loader = () => null;

export const meta = () => [{ title: appendToMetaTitle("Authentication") }];

export default function App() {
  return (
    <main className="flex h-screen items-center justify-center">
      <div className="flex size-full flex-col items-center justify-center p-6 lg:p-10">
        <div className="mb-8 text-center">
          <ShelfSymbolLogo />
        </div>
        <div className="w-[360px]">
          <Outlet />
        </div>
      </div>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
