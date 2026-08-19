import { Icon, ToastProvider } from "@/components/ui";
import { ThemeProvider } from "@/components/shell/theme";

/**
 * Chrome for the signed-out screens.
 *
 * Deliberately not the application shell: there is no navigation to offer and
 * no run to report on, and showing a disabled sidebar to someone who cannot get
 * in yet is just noise.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
          <div className="w-full max-w-md space-y-6">
            <div className="flex items-center justify-center gap-2.5">
              <span className="grid size-9 place-items-center rounded-lg bg-accent text-on-accent">
                <Icon name="package" className="size-5" />
              </span>
              <span className="font-mono text-lg font-semibold tracking-tight text-ink">
                GOP_IMPORT
              </span>
            </div>

            {children}

            <p className="text-center text-2xs text-ink-subtle">
              Bulk product publishing for WooCommerce
            </p>
          </div>
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
}
