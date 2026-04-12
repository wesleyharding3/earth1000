import UIKit
import Capacitor
import WebKit

/// Custom Capacitor bridge view controller that enables inline media playback
/// in WKWebView — required for YouTube iframe embeds on iOS (fixes error 153).
class EarthViewController: CAPBridgeViewController {

    // Capacitor 8.x signature: InstanceConfiguration (not InstanceDescriptor)
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)

        // ── Critical: enable inline video playback ──
        // Without this, WKWebView forces YouTube iframes into fullscreen,
        // and embedded players fail with error 153.
        config.allowsInlineMediaPlayback = true

        // Allow autoplay without requiring a user gesture
        config.mediaTypesRequiringUserActionForPlayback = []

        // Allow AirPlay
        config.allowsAirPlayForMediaPlayback = true

        return config
    }
}
