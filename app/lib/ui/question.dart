// One of pi's questions, in the composer's place while it waits: pi cannot
// read a message until it is answered. A confirm's No and Yes, a select's
// options, each with a note for pi that goes with the answer; an input's
// text, which is the answer; "Dismiss and stop", which closes the question
// and stops the turn. An editor or an extension's own dialog only pi's
// terminal can answer: where pi runs, and Stop.
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/names.dart';
import '../core/question_text.dart';
import '../core/view.dart';
import 'look.dart';
import 'selectable.dart';

class QuestionDock extends StatefulWidget {
  const QuestionDock({super.key, required this.q, required this.more, required this.model, required this.session, this.room});
  final QuestionView q;
  // The screen's height above the keyboard, as the chat read it: under its
  // scaffold the keyboard is no longer in the MediaQuery.
  final double? room;
  // Questions waiting after this one.
  final int more;
  final PircModel model;
  final SessionView session;

  @override
  State<QuestionDock> createState() => _QuestionDockState();
}

class _QuestionDockState extends State<QuestionDock> {
  final _note = TextEditingController();
  final _text = TextEditingController();
  var _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _note.addListener(_changed);
    _text.addListener(_changed);
  }

  @override
  void dispose() {
    _note.dispose();
    _text.dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  Future<void> _answer({int? option, bool? confirmed, String? text, bool dismissed = false}) async {
    setState(() => _sending = true);
    final note = dismissed || text != null ? '' : _note.text.trim();
    final o = await widget.model.answer(widget.session.id, widget.q.id, option: option, confirmed: confirmed, text: text, dismissed: dismissed, note: note);
    if (mounted) {
      setState(() {
        _sending = false;
        _error = o.ok ? null : o.message;
      });
    }
  }

  Future<void> _stop() async {
    setState(() => _sending = true);
    final o = await widget.model.stop(widget.session.id);
    if (mounted) {
      setState(() {
        _sending = false;
        _error = o.ok ? null : o.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final q = widget.q;
    final lines = q.title.split('\n');
    final blocks = questionBlocks([...lines.skip(1), ?q.message].join('\n'));
    final answerable = q.answerable && const {'confirm', 'select', 'input'}.contains(q.kind);

    Widget button(String label, VoidCallback f, {bool primary = false, Widget? lead}) => CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          minimumSize: const Size(0, 46),
          color: primary ? look.accent : look.wash2,
          borderRadius: BorderRadius.circular(13),
          onPressed: _sending ? null : f,
          child: Align(
            alignment: lead != null ? Alignment.centerLeft : Alignment.center,
            widthFactor: lead != null ? null : 1,
            child: Row(mainAxisSize: lead != null ? MainAxisSize.max : MainAxisSize.min, children: [
              ?lead,
              Flexible(child: Text(label, style: look.text(size: 15.5, weight: lead != null ? FontWeight.w500 : FontWeight.w600, color: primary ? look.onAccent : look.ink, spacing: 0))),
            ]),
          ),
        );

    Widget field(TextEditingController c, String placeholder, {ValueChanged<String>? submit, bool prose = false}) => CupertinoTextField(
          controller: c,
          placeholder: placeholder,
          minLines: 1,
          maxLines: 4,
          // A note is a sentence; an answer is often a name or a path.
          textCapitalization: prose ? TextCapitalization.sentences : TextCapitalization.none,
          textInputAction: submit != null ? TextInputAction.send : TextInputAction.newline,
          onSubmitted: submit,
          style: look.text(size: 15),
          placeholderStyle: look.text(size: 15, color: look.ink3),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(14), border: Border.all(color: c.text.isNotEmpty ? look.accent : look.rule)),
        );

    final eyebrow = Row(mainAxisSize: MainAxisSize.min, spacing: 6, children: [
      Container(width: 7, height: 7, decoration: BoxDecoration(color: look.accent, shape: BoxShape.circle)),
      Text(answerable ? 'PI ASKS' : 'PI ASKS IN ITS TERMINAL', style: look.text(size: 12, weight: FontWeight.w600, color: look.accent, spacing: 0.5)),
    ]);

    // The question, scrolled within the dock when it is long, so that its
    // answers stay in view.
    final question = Selectable(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 6, children: [
        Text(lines.first.isNotEmpty ? lines.first : 'pi asks', style: look.text(size: 16, weight: FontWeight.w600, spacing: 0)),
        for (final b in blocks)
          switch (b) {
            QuestionText(:final text) => Text(text, style: look.text(size: 14, color: look.ink2, spacing: 0)),
            QuestionField(:final label, :final value) => Text.rich(TextSpan(children: [
                TextSpan(text: '$label  ', style: look.text(size: 14, color: look.ink3, spacing: 0)),
                TextSpan(text: value, style: look.text(size: 14, color: look.ink, spacing: 0)),
              ])),
            QuestionCode(:final code, :final label) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 4, children: [
                if (label != null) Text(label, style: look.text(size: 14, color: look.ink3, spacing: 0)),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
                  decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
                  child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Text(code, style: look.mono(size: 12.5, color: look.ink).copyWith(height: 1.45), softWrap: false)),
                ),
              ]),
            QuestionGap() => const SizedBox(height: 2),
          },
        if (widget.more > 0) Text('${widget.more} more after this one', style: look.text(size: 13, color: look.ink3, spacing: 0)),
      ]),
    );

    // What is left above the keyboard: everything under the eyebrow scrolls
    // within a share of it, so that on a small phone with the keyboard up
    // no option nor the note is out of reach; the question's own text
    // within a share of that, as before when there is room.
    final media = MediaQuery.of(context);
    final full = media.size.height - media.padding.top;
    final left = widget.room ?? full;
    // Less of it with the keyboard up, so that the chat keeps a little.
    final budget = math.max(120.0, left * (left < full - 1 ? 0.4 : 0.7));
    final questionMax = math.min(media.size.height * 0.38, budget * 0.6);

    return Semantics(
      label: 'pi asks',
      container: true,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // The eyebrow, with Dismiss at its end as a whole 44 points.
          SizedBox(
            height: 44,
            child: Row(children: [
              eyebrow,
              const Spacer(),
              if (answerable)
                CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  minimumSize: const Size(44, 44),
                  onPressed: _sending ? null : () => _answer(dismissed: true),
                  child: Text('Dismiss and stop', style: look.text(size: 14, weight: FontWeight.w500, color: look.ink2, spacing: 0)),
                ),
            ]),
          ),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: budget),
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 10, children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxHeight: questionMax),
          child: SingleChildScrollView(child: question),
        ),
        if (!answerable) ...[
          Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 4, children: [
            Text("This needs pi's terminal to answer.", style: look.text(size: 14, color: look.ink2, spacing: 0)),
            Text(where(widget.session), style: look.text(size: 12.5, color: look.ink3, spacing: 0)),
          ]),
          Align(
            alignment: Alignment.centerLeft,
            child: CupertinoButton(
              padding: EdgeInsets.zero,
              minimumSize: const Size(44, 44),
              onPressed: _sending ? null : _stop,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(border: Border.all(color: look.block), borderRadius: BorderRadius.circular(14)),
                child: Row(mainAxisSize: MainAxisSize.min, spacing: 6, children: [
                  Container(width: 9, height: 9, decoration: BoxDecoration(color: look.block, borderRadius: BorderRadius.circular(1.5))),
                  Text('Stop pi', style: look.text(size: 14, weight: FontWeight.w600, color: look.block, spacing: 0)),
                ]),
              ),
            ),
          ),
        ],
        if (answerable && q.kind == 'select')
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 8, children: [
            for (final (i, o) in (q.options ?? const <String>[]).indexed)
              button(o, () => _answer(option: i), lead: SizedBox(width: 22, child: Text('${i + 1}', style: look.text(size: 15.5, color: look.ink3, spacing: 0).copyWith(fontFeatures: const [FontFeature.tabularFigures()])))),
          ]),
        if (answerable && q.kind != 'input') ...[
          field(_note, 'Add a note for pi', prose: true),
          if (_note.text.isNotEmpty) Text('pi gets the note with your answer.', style: look.text(size: 12.5, color: look.ink3, spacing: 0)),
        ],
        if (answerable && q.kind == 'confirm')
          Row(spacing: 8, children: [
            Expanded(child: button('No', () => _answer(confirmed: false))),
            Expanded(child: button('Yes', () => _answer(confirmed: true), primary: true)),
          ]),
        if (answerable && q.kind == 'input') ...[
          field(_text, q.placeholder ?? 'Your answer', submit: (v) => _answer(text: v)),
          button('Send', () => _answer(text: _text.text), primary: true),
        ],
        if (_error != null) Text(_error!, style: look.text(size: 13.5, color: look.block, spacing: 0)),
              ]),
            ),
          ),
      ]),
    );
  }
}
