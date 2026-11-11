import AppKit
import Foundation
// Synthetic hidden GUI: no NAW package, user profile or provider is loaded here.
let configURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/fixture.json")
let config = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: String]
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let backend = Process()
backend.executableURL = URL(fileURLWithPath: config["node"]!)
backend.arguments = [configURL.deletingLastPathComponent().appendingPathComponent(config["bootstrap"]!).path, configURL.path]
backend.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": config["home"]!, "TMPDIR": config["tmp"]!]
let log = FileHandle(forWritingAtPath: config["log"]!)!
backend.standardOutput = log; backend.standardError = log
try backend.run()
app.run()
