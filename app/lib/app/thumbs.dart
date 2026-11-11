// A message's image made small, to keep with its chat (chat_cache.dart), as
// design.md has it (section 12, step 13, "What the phone keeps"): drawn by
// the engine at the height a thumbnail shows at on a 3x screen, then a
// photo as a JPEG and anything else, which may be transparent, as a PNG.
import 'dart:isolate';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import '../core/images.dart';

// A thumbnail's 96 points (ui/images.dart) at 3x.
const thumbHeight = 288;

// The image made small; the image itself when that is no smaller, and null
// when it cannot be drawn.
Future<StoredImage?> thumbnail(StoredImage image) async {
  try {
    final buffer = await ui.ImmutableBuffer.fromUint8List(image.data);
    final d = await ui.ImageDescriptor.encoded(buffer);
    final codec = await d.instantiateCodec(targetHeight: d.height > thumbHeight ? thumbHeight : null);
    final frame = await codec.getNextFrame();
    final small = frame.image;
    final Uint8List data;
    final String type;
    if (image.mimeType == 'image/jpeg') {
      final rgba = (await small.toByteData(format: ui.ImageByteFormat.rawRgba))!;
      final (w, h) = (small.width, small.height);
      // Encoded off the UI thread: saves come while a reply streams.
      data = await Isolate.run(() => img.encodeJpg(img.Image.fromBytes(width: w, height: h, bytes: rgba.buffer, numChannels: 4, order: img.ChannelOrder.rgba), quality: 80));
      type = 'image/jpeg';
    } else {
      data = (await small.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      type = 'image/png';
    }
    small.dispose();
    codec.dispose();
    d.dispose();
    buffer.dispose();
    return data.length < image.data.length ? StoredImage(type, data) : image;
  } on Object catch (e) {
    debugPrint('pirc: no thumbnail: $e');
    return null;
  }
}
