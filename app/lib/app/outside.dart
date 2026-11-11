// Trips out of the app that come straight back to it: the photo picker,
// the camera, the system's prompts. Android goes to the background for
// them, and the lock does not count that as leaving, up to tripMax.
var _outside = 0;

// How long a trip may last before it counts as leaving.
const tripMax = Duration(minutes: 5);

// Whether one is under way.
bool get outside => _outside > 0;

// Runs f as such a trip.
Future<T> goingOutside<T>(Future<T> Function() f) async {
  _outside++;
  try {
    return await f();
  } finally {
    _outside--;
  }
}
