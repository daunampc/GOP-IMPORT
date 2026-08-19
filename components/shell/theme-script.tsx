// components/theme-script.tsx  — KHÔNG có "use client"
export const THEME_STORAGE_KEY = "tsd-theme";

export function ThemeScript() {
  const source = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE_KEY,
  )});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;

  return <script dangerouslySetInnerHTML={{ __html: source }} suppressHydrationWarning />;
}
