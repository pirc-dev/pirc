// swift-tools-version: 5.9
// The app's key store and prefs on iOS (pubspec.yaml).
import PackageDescription

let package = Package(
    name: "pirc_platform",
    platforms: [.iOS("15.0")],
    products: [.library(name: "pirc-platform", targets: ["pirc_platform"])],
    dependencies: [.package(name: "FlutterFramework", path: "../FlutterFramework")],
    targets: [
        .target(name: "pirc_platform", dependencies: [.product(name: "FlutterFramework", package: "FlutterFramework")]),
    ]
)
