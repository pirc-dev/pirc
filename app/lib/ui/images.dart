// Images in messages, as the web page's (web/page/src/Images.tsx,
// attach.ts, docs/web.md, section 6): a message's images as thumbnails that
// open full screen, and pictures chosen from the phone's photos or taken
// with its camera for a message, made to fit pi's limits as they are picked.
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../app/outside.dart';
import '../core/images.dart';
import 'look.dart';

// pi's limits, as web/core/api.ts has them: four images a message, each
// at most 2000 pixels a side and 2 MiB, in one of these types.
const imagesMax = 4;
const imageSide = 2000.0;
const imageBytesMax = 2 << 20;
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// An image's type, from its first bytes; null for none of pi's.
String? imageType(Uint8List b) {
  bool starts(List<int> sig, [int at = 0]) => b.length >= at + sig.length && [for (var i = 0; i < sig.length; i++) b[at + i] == sig[i]].every((x) => x);
  if (starts([0x89, 0x50, 0x4E, 0x47])) return 'image/png';
  if (starts([0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

// Why an image picked cannot be sent.
class NotSendable implements Exception {
  const NotSendable(this.message);
  final String message;
  @override
  String toString() => message;
}

// An image as it is sent; throws NotSendable when it cannot be.
StoredImage sendable(Uint8List data) {
  final type = imageType(data);
  if (type == null) throw const NotSendable('That picture is in a kind pi does not take; a PNG or JPEG will do.');
  if (data.length > imageBytesMax) throw const NotSendable('That image is too large to send, even made smaller.');
  return StoredImage(type, data);
}

// Pictures from the phone's photos, at most room of them, each made to fit
// within pi's side by the picker; with why any could not be sent.
Future<({List<StoredImage> images, String? problem})> pickImages(int room, {ImagePicker? picker}) async {
  final files = await goingOutside(() => (picker ?? ImagePicker()).pickMultiImage(maxWidth: imageSide, maxHeight: imageSide, imageQuality: 85, limit: room > 1 ? room : null));
  return _checked(files, room);
}

// A photo taken with the camera, as the web's file input offers on a phone,
// made to fit and checked as the photos' are; none when the camera was
// closed without one. Android asks for the camera as it opens.
Future<({List<StoredImage> images, String? problem})> takePhoto({ImagePicker? picker}) async {
  try {
    final file = await goingOutside(() => (picker ?? ImagePicker()).pickImage(source: ImageSource.camera, maxWidth: imageSide, maxHeight: imageSide, imageQuality: 85));
    return await _checked([?file], 1);
  } on PlatformException catch (e) {
    return (
      images: const <StoredImage>[],
      problem: switch (e.code) {
        'camera_access_denied' => "PiRC may not use the camera. Allow it in the phone's Settings, under PiRC, or choose from your photos instead.",
        'no_available_camera' => 'This phone has no camera to take a photo with.',
        _ => 'The camera could not start${e.message == null ? '' : ': ${e.message}'}.',
      },
    );
  }
}

Future<({List<StoredImage> images, String? problem})> _checked(List<XFile> files, int room) async {
  final images = <StoredImage>[];
  String? problem;
  if (files.length > room) problem = 'At most $imagesMax images in a message.';
  for (final f in files.take(room)) {
    try {
      images.add(sendable(await f.readAsBytes()));
    } on NotSendable catch (e) {
      problem = e.message;
    } on Object {
      problem = 'That picture could not be read.';
    }
  }
  return (images: images, problem: problem);
}

// A message's images in a row; each opens full screen. One that came
// without its data, or no longer kept, is a placeholder.
class Thumbs extends StatelessWidget {
  const Thumbs({super.key, required this.images, this.onRemove});
  // Each one's data, or null for a placeholder.
  final List<Uint8List?> images;
  // Removes one, from a message not yet sent.
  final void Function(int i)? onRemove;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Wrap(spacing: 6, runSpacing: 6, children: [
      for (final (i, data) in images.indexed)
        Stack(clipBehavior: Clip.none, children: [
          if (data == null)
            Container(
              height: 64,
              constraints: const BoxConstraints(minWidth: 64),
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(color: look.wash2, borderRadius: BorderRadius.circular(8)),
              child: Center(widthFactor: 1, child: Text('Image', style: look.text(size: 12.5, color: look.ink2, spacing: 0))),
            )
          else
            Semantics(
              container: true,
              button: true,
              label: 'Open image',
              child: GestureDetector(
                onTap: () => Navigator.of(context, rootNavigator: true).push(PageRouteBuilder<void>(
                  opaque: false,
                  barrierColor: const Color(0xFF000000),
                  pageBuilder: (_, _, _) => Viewer(data),
                  transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
                )),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 192),
                    child: Image.memory(data, height: 96, fit: BoxFit.cover, gaplessPlayback: true, errorBuilder: (_, _, _) => _broken(look)),
                  ),
                ),
              ),
            ),
          if (onRemove != null)
            Positioned(
              top: -8,
              right: -8,
              child: Semantics(
                container: true,
                button: true,
                label: 'Remove image',
                excludeSemantics: true,
                onTap: () => onRemove!(i),
                child: GestureDetector(
                  onTap: () => onRemove!(i),
                  child: Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(color: look.ink, shape: BoxShape.circle, border: Border.all(color: look.page, width: 2)),
                    child: Icon(CupertinoIcons.xmark, size: 12, color: look.page),
                  ),
                ),
              ),
            ),
        ]),
    ]);
  }

  Widget _broken(Look look) => Container(
        width: 64,
        height: 64,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: look.wash2, borderRadius: BorderRadius.circular(8)),
        child: Text('Image', style: look.text(size: 12.5, color: look.ink2, spacing: 0)),
      );
}

// An image full screen, on black, to zoom into; closed by its × or a tap.
class Viewer extends StatelessWidget {
  const Viewer(this.data, {super.key});
  final Uint8List data;

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return Semantics(
      scopesRoute: true,
      explicitChildNodes: true,
      label: 'Image',
      child: GestureDetector(
        onTap: () => Navigator.of(context).pop(),
        child: ColoredBox(
          color: const Color(0xFF000000),
          child: Column(children: [
            Padding(
              padding: EdgeInsets.only(top: pad.top, right: pad.right < 8 ? 8 : pad.right),
              child: Align(
                alignment: Alignment.centerRight,
                child: Semantics(
                  button: true,
                  label: 'Close',
                  excludeSemantics: true,
                  onTap: () => Navigator.of(context).pop(),
                  child: CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(44, 44),
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Icon(CupertinoIcons.xmark, size: 20, color: Color(0xFFFFFFFF)),
                  ),
                ),
              ),
            ),
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(bottom: pad.bottom),
                child: InteractiveViewer(maxScale: 6, child: Center(child: Image.memory(data, fit: BoxFit.contain))),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
