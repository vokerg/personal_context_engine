export type Appearance = "system" | "light" | "dark";
export type Palette = {
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  secondary: string;
  border: string;
  primary: string;
  onPrimary: string;
  subtle: string;
  danger: string;
};

const light: Palette = {
  dark: false,
  background: "#F5F8FC",
  surface: "#FFFFFF",
  text: "#142B43",
  secondary: "#42566D",
  border: "#CDD9E5",
  primary: "#174F89",
  onPrimary: "#FFFFFF",
  subtle: "#E9F1FA",
  danger: "#922A2A",
};

const dark: Palette = {
  dark: true,
  background: "#0C1625",
  surface: "#17263A",
  text: "#F1F6FB",
  secondary: "#C0D1E2",
  border: "#425773",
  primary: "#9CCEFF",
  onPrimary: "#0B1A2A",
  subtle: "#253B55",
  danger: "#FFB5B5",
};

export function paletteFor(
  appearance: Appearance,
  system: "light" | "dark" | null | undefined,
): Palette {
  return appearance === "dark" ||
    (appearance === "system" && system === "dark")
    ? dark
    : light;
}
