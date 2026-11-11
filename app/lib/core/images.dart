// The images of user messages, kept by content. A port of
// web/core/images.ts.
import 'dart:typed_data';

class StoredImage {
  const StoredImage(this.mimeType, this.data);
  final String mimeType;
  final Uint8List data;
}

int _mul(int a, int b) => (a * b) & 0xffffffff;

// 64 bits of FNV-1a, in two 32-bit halves, with the length and type: a
// name, not a defence. The same as Math.imul's 32-bit arithmetic.
String imageKey(String mimeType, List<int> data) {
  var a = 0x811c9dc5;
  var b = 0x050c5d1f;
  for (final x in data) {
    a = _mul(a ^ x, 0x01000193);
    b = _mul(b ^ x, 0x01000193) ^ (a >> 15);
  }
  for (final c in mimeType.codeUnits) {
    a = _mul(a ^ c, 0x01000193);
  }
  String hex(int n) => n.toRadixString(16).padLeft(8, '0');
  return '${hex(a)}${hex(b)}${data.length.toRadixString(16)}';
}

// Bounded: past the limit the least recently used go.
class ImageStore {
  ImageStore(this.maxBytes);

  final int maxBytes;
  // In order of use, the least recent first.
  final _images = <String, StoredImage>{};
  // Those held only as thumbnails, under their image's key.
  final _small = <String>{};
  var _bytes = 0;

  // Keeps an image; its key. One held as a thumbnail is replaced by it.
  String put(String mimeType, Uint8List data) {
    final key = imageKey(mimeType, data);
    final had = _images.remove(key);
    if (had != null && !_small.contains(key)) {
      _images[key] = had;
      return key;
    }
    if (had != null) {
      _bytes -= had.data.length;
      _small.remove(key);
    }
    _add(key, StoredImage(mimeType, data));
    return key;
  }

  // Keeps an image's thumbnail under the image's key, while the image
  // itself is not held.
  void putSmall(String key, StoredImage thumb) {
    if (_images.containsKey(key)) return;
    if (_add(key, thumb)) _small.add(key);
  }

  bool _add(String key, StoredImage image) {
    if (image.data.length > maxBytes) return false;
    _images[key] = image;
    _bytes += image.data.length;
    while (_bytes > maxBytes) {
      final k = _images.keys.first;
      _bytes -= _images.remove(k)!.data.length;
      _small.remove(k);
    }
    return _images.containsKey(key);
  }

  StoredImage? get(String key) {
    final it = _images.remove(key);
    if (it != null) _images[key] = it;
    return it;
  }
}
