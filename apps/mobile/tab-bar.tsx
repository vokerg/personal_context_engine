import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import TabView, {
  useBottomTabBarHeight,
  type AppleIcon,
} from "react-native-bottom-tabs";
import type { MobileTab } from "./navigation";
import type { Palette } from "./theme";

type Route = {
  key: MobileTab;
  title: string;
  focusedIcon: AppleIcon;
  unfocusedIcon: AppleIcon;
  role?: "search";
};
const routes: Route[] = [
  {
    key: "notes",
    title: "Notes",
    focusedIcon: { sfSymbol: "doc.text.fill" },
    unfocusedIcon: { sfSymbol: "doc.text" },
  },
  {
    key: "tasks",
    title: "Tasks",
    focusedIcon: { sfSymbol: "checkmark.circle.fill" },
    unfocusedIcon: { sfSymbol: "checkmark.circle" },
  },
  {
    key: "capture",
    title: "Capture",
    focusedIcon: { sfSymbol: "plus.circle.fill" },
    unfocusedIcon: { sfSymbol: "plus.circle" },
  },
  {
    key: "settings",
    title: "Settings",
    focusedIcon: { sfSymbol: "gearshape.fill" },
    unfocusedIcon: { sfSymbol: "gearshape" },
  },
  {
    key: "search",
    title: "Search",
    focusedIcon: { sfSymbol: "magnifyingglass" },
    unfocusedIcon: { sfSymbol: "magnifyingglass" },
    role: "search",
  },
];

function Scene({
  tab,
  render,
}: {
  tab: MobileTab;
  render: (tab: MobileTab, bottomInset: number) => ReactNode;
}) {
  const height = useBottomTabBarHeight();
  // Insets are manual: the app's lists retain their existing content/scroll layout.
  return render(tab, Math.max(height, 80) + 16);
}

/** System SwiftUI TabView/UITabBarController owns the bar and Liquid Glass.
 * No custom surface, selection indicator, translucency override or tab buttons.
 */
export function NativeTabs({
  active,
  palette,
  onSelect,
  renderScene,
  hidden = false,
  tasksEnabled = false,
}: {
  active: MobileTab;
  palette: Palette;
  onSelect: (tab: MobileTab) => void;
  renderScene: (tab: MobileTab, bottomInset: number) => ReactNode;
  hidden?: boolean;
  tasksEnabled?: boolean;
}) {
  const visibleRoutes = useMemo(
    () => routes.filter((route) => tasksEnabled || route.key !== "tasks"),
    [tasksEnabled],
  );
  const index = Math.max(
    0,
    visibleRoutes.findIndex((route) => route.key === active),
  );
  return (
    <View
      style={{ flex: 1, backgroundColor: palette.background }}
      pointerEvents={hidden ? "none" : "auto"}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
    >
      <TabView
        navigationState={{ index, routes: visibleRoutes }}
        onIndexChange={(next) => {
          const route = visibleRoutes[next];
          if (route && !hidden) onSelect(route.key);
        }}
        renderScene={({ route }) => (
          <Scene tab={route.key} render={renderScene} />
        )}
        getLazy={() => false}
        tabBarHidden={hidden}
        labeled
        tabBarActiveTintColor={palette.primary}
        scrollEdgeAppearance="default"
        minimizeBehavior="never"
      />
    </View>
  );
}
