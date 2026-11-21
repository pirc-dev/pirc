// uint64s as the wire has them, held in fixnum's signed Int64: compared
// and written unsigned, so that a number from 2^63 on orders after the
// rest as it does in the Go, the TypeScript and the Swift, and is written
// as the decimal they read.
import 'package:fixnum/fixnum.dart';

int compareU64(Int64 a, Int64 b) => (a ^ Int64.MIN_VALUE).compareTo(b ^ Int64.MIN_VALUE);

bool gtU64(Int64 a, Int64 b) => compareU64(a, b) > 0;
bool geU64(Int64 a, Int64 b) => compareU64(a, b) >= 0;

String u64Text(Int64 v) => v.toStringUnsigned();
