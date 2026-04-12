import UIKit
import Capacitor
import WebKit

/// Custom Capacitor bridge view controller that enables inline media playback
/// in WKWebView — required for YouTube iframe embeds on iOS (fixes error 153).
///
/// Also overrides the navigation delegate to keep YouTube/video embeds inside
/// the WebView rather than opening them in the in-app browser (SFSafariViewController).
class EarthViewController: CAPBridgeViewController {

    /// Domains that should always load inside the WebView (iframes, sub-resources)
    /// rather than being redirected to the in-app browser.
    private static let inlineAllowedHosts: Set<String> = [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
        "googlevideo.com",
        "earth-wjr6.onrender.com"
    ]

    override func webViewConfiguration(for bridge: InstanceDescriptor) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: bridge)

        // Enable inline video playback (without this, YouTube embeds fail with error 153)
        config.allowsInlineMediaPlayback = true

        // Allow autoplay without user gesture (matches our embed params)
        config.mediaTypesRequiringUserActionForPlayback = []

        // Allow AirPlay
        config.allowsAirPlayForMediaPlayback = true

        // Ensure preferences allow JS and inline media
        config.preferences.javaScriptEnabled = true

        return config
    }

    override func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {

        guard let url = navigationAction.request.url, let host = url.host?.lowercased() else {
            super.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
            return
        }

        // Allow iframe/sub-frame loads to YouTube and our API — keep them inside the WebView
        if navigationAction.targetFrame != nil && !navigationAction.targetFrame!.isMainFrame {
            // This is an iframe navigation — check if it's to an allowed domain
            let isAllowed = Self.inlineAllowedHosts.contains(where: { allowed in
                host == allowed || host.hasSuffix(".\(allowed)")
            })
            if isAllowed {
                decisionHandler(.allow)
                return
            }
        }

        // For top-level navigations to video embeds (e.g. fullscreen),
        // also keep them in the WebView
        if navigationAction.targetFrame?.isMainFrame == true {
            let isVideoEmbed = url.path.contains("/embed/") || url.path.contains("/api/video-embed")
            let isAllowedHost = Self.inlineAllowedHosts.contains(where: { allowed in
                host == allowed || host.hasSuffix(".\(allowed)")
            })
            if isVideoEmbed && isAllowedHost {
                decisionHandler(.allow)
                return
            }
        }

        // Everything else: let Capacitor's default handler decide
        super.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }
}
