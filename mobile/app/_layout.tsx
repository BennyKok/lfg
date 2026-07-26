import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LfgProvider } from "../src/lfg";
import { colors } from "../src/theme";
export default function Layout() {
  return (
    <LfgProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
      </Stack>
    </LfgProvider>
  );
}
