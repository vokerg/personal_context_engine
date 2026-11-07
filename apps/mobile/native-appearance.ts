import * as SecureStore from "expo-secure-store";
import type { AppearanceStore } from "./appearance";
const key = "pce.appearance.v1";
export const appearanceStore: AppearanceStore = {
  read: () => SecureStore.getItemAsync(key),
  write: (value) => SecureStore.setItemAsync(key, value),
};
