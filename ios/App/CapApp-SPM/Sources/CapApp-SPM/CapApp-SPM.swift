// Force-link Capacitor plugin modules so Swift's dead-code stripper
// doesn't drop their @objc(...) classes from the final binary. Without
// these imports, the runtime can't find the plugin classes at app
// startup and they're missing from window.Capacitor.Plugins, even
// though Package.swift declares them as dependencies. Note: import
// names match each plugin's Swift TARGET name (not the library name
// listed in Package.swift's products). For SignInWithApple the
// library is "CapacitorCommunityAppleSignIn" but the target is
// "SignInWithApple".
import SignInWithApple
import RevenuecatPurchasesCapacitor

public let isCapacitorApp = true
