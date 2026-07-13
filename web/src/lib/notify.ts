// A drop-in replacement for sonner's `toast` that also plays the matching UI
// feedback. Import `toast` from here instead of "sonner" and every existing
// `toast.success(...)` / `toast.error(...)` call gains a sound + haptic with no
// change at the call site. All other toast methods (message, promise, custom,
// dismiss, the callable form) pass straight through untouched.

import { toast as sonnerToast } from "sonner";
import { feedback } from "./feedback";

export const toast: typeof sonnerToast = new Proxy(sonnerToast, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (prop === "success" && typeof value === "function") {
      return (...args: Parameters<typeof sonnerToast.success>) => {
        feedback.success();
        return (value as typeof sonnerToast.success)(...args);
      };
    }
    if (prop === "error" && typeof value === "function") {
      return (...args: Parameters<typeof sonnerToast.error>) => {
        feedback.error();
        return (value as typeof sonnerToast.error)(...args);
      };
    }
    // Bind plain function methods so `this` stays the real toast object.
    return typeof value === "function" ? value.bind(target) : value;
  },
});
