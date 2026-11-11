// swift-tools-version:5.9
// The iOS notification extension's core (docs/design.md, section 12, step
// 13): logs in to the relay with the read-only key, reads the session list
// and writes the notifications, as web/core/notices.ts does. Pure: the
// extension target reads and writes storage and posts what it returns.
import PackageDescription

let package = Package(
    name: "PircNotices",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "PircNotices", targets: ["PircNotices"])],
    dependencies: [.package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0")],
    targets: [
        .target(name: "PircNotices", dependencies: [.product(name: "SwiftProtobuf", package: "swift-protobuf")]),
        .testTarget(name: "PircNoticesTests", dependencies: ["PircNotices"]),
    ]
)
