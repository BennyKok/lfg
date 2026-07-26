import { NativeTabs } from 'expo-router/unstable-native-tabs';

// NativeTabs renders a real UITabBar on iOS. On iOS 26 that means the system
// applies Liquid Glass to the tab bar for free — the scroll-edge blur, the
// specular highlight, and the shrink-on-scroll behaviour are all UIKit's, not
// ours. That is the whole point of using native tabs over a JS tab bar.
export default function TabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
        <NativeTabs.Trigger.Label>Todos</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="glass">
        <NativeTabs.Trigger.Icon
          sf="circle.hexagongrid.fill"
          md="blur_on"
        />
        <NativeTabs.Trigger.Label>Glass</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="about">
        <NativeTabs.Trigger.Icon sf="info.circle" md="info" />
        <NativeTabs.Trigger.Label>About</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
