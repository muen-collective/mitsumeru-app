import CoreGraphics
import Foundation

// Lists on-screen windows owned by Mitsumeru with their CGWindow ids and
// bounds — used to target `screencapture -l<id>` when CDP is blocked by the
// app-modal offer dialog.
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  if owner.lowercased().contains("mitsumeru") {
    let num = w[kCGWindowNumber as String] as? Int ?? -1
    let name = w[kCGWindowName as String] as? String ?? ""
    let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let layer = w[kCGWindowLayer as String] as? Int ?? -99
    print("id=\(num) layer=\(layer) owner=\(owner) name=\(name) bounds=\(bounds)")
  }
}
