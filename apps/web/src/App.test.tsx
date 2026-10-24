import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.js";

describe("web authenticated shell", () => {
  it("offers a local connection without manual token entry in explicit developer mode", () => {
    const markup = renderToStaticMarkup(
      <App localDevelopment baseUrl="http://127.0.0.1:3110" />,
    );
    expect(markup).toContain("Connect local workspace");
    expect(markup).not.toContain("Development access token");
  });
  it("renders a sign-in-required state with no private content or token persistence", () => {
    const markup = renderToStaticMarkup(<App baseUrl="https://api.example" />);
    expect(markup).toContain("Sign-in required");
    expect(markup).toContain('id="theme-preference"');
    expect(markup).toContain('value="system" selected=""');
    expect(markup).toContain('<option value="light">Light</option>');
    expect(markup).toContain('<option value="dark">Dark</option>');
    expect(markup).toContain("Development access token");
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain("Synthetic Alice");
    expect(markup).not.toContain("localStorage");
  });
});
