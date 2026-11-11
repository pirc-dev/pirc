// Code blocks highlighted as the web page highlights them (Markdown.tsx's
// rehype-highlight, with lowlight's common languages): only a block that
// names its language, since guessing one is slow and often wrong for a
// short block; in Native's colours (index.css's .hljs- rules), by
// re_highlight, a port of the same highlight.js.
import 'package:flutter/painting.dart';
import 'package:re_highlight/languages/arduino.dart';
import 'package:re_highlight/languages/bash.dart';
import 'package:re_highlight/languages/c.dart';
import 'package:re_highlight/languages/cpp.dart';
import 'package:re_highlight/languages/csharp.dart';
import 'package:re_highlight/languages/css.dart';
import 'package:re_highlight/languages/diff.dart';
import 'package:re_highlight/languages/go.dart';
import 'package:re_highlight/languages/graphql.dart';
import 'package:re_highlight/languages/ini.dart';
import 'package:re_highlight/languages/java.dart';
import 'package:re_highlight/languages/javascript.dart';
import 'package:re_highlight/languages/json.dart';
import 'package:re_highlight/languages/kotlin.dart';
import 'package:re_highlight/languages/less.dart';
import 'package:re_highlight/languages/lua.dart';
import 'package:re_highlight/languages/makefile.dart';
import 'package:re_highlight/languages/markdown.dart';
import 'package:re_highlight/languages/objectivec.dart';
import 'package:re_highlight/languages/perl.dart';
import 'package:re_highlight/languages/php-template.dart';
import 'package:re_highlight/languages/php.dart';
import 'package:re_highlight/languages/plaintext.dart';
import 'package:re_highlight/languages/python-repl.dart';
import 'package:re_highlight/languages/python.dart';
import 'package:re_highlight/languages/r.dart';
import 'package:re_highlight/languages/ruby.dart';
import 'package:re_highlight/languages/rust.dart';
import 'package:re_highlight/languages/scss.dart';
import 'package:re_highlight/languages/shell.dart';
import 'package:re_highlight/languages/sql.dart';
import 'package:re_highlight/languages/swift.dart';
import 'package:re_highlight/languages/typescript.dart';
import 'package:re_highlight/languages/vbnet.dart';
import 'package:re_highlight/languages/wasm.dart';
import 'package:re_highlight/languages/xml.dart';
import 'package:re_highlight/languages/yaml.dart';
import 'package:re_highlight/re_highlight.dart';

import 'look.dart';

final _highlight = Highlight()
  ..registerLanguages({
    'arduino': langArduino,
    'bash': langBash,
    'c': langC,
    'cpp': langCpp,
    'csharp': langCsharp,
    'css': langCss,
    'diff': langDiff,
    'go': langGo,
    'graphql': langGraphql,
    'ini': langIni,
    'java': langJava,
    'javascript': langJavascript,
    'json': langJson,
    'kotlin': langKotlin,
    'less': langLess,
    'lua': langLua,
    'makefile': langMakefile,
    'markdown': langMarkdown,
    'objectivec': langObjectivec,
    'perl': langPerl,
    'php': langPhp,
    'php-template': langPhpTemplate,
    'plaintext': langPlaintext,
    'python': langPython,
    'python-repl': langPythonRepl,
    'r': langR,
    'ruby': langRuby,
    'rust': langRust,
    'scss': langScss,
    'shell': langShell,
    'sql': langSql,
    'swift': langSwift,
    'typescript': langTypescript,
    'vbnet': langVbnet,
    'wasm': langWasm,
    'xml': langXml,
    'yaml': langYaml,
  });

// The blocks last drawn, so that a reply as it streams, drawn again with
// each piece, does not highlight its finished blocks again: the least
// recently drawn go first (a map keeps the order of insertion, and a block
// drawn again is put back at its end).
final _done = <(String, String, Look), TextSpan?>{};

// The code as spans, each in its scope's colour over [base]; null when the
// language is not one of these, and the code is then drawn plain.
TextSpan? highlight(String code, String? lang, Look look, TextStyle base) {
  if (lang == null || _highlight.getLanguage(lang) == null) return null;
  final key = (lang, code, look);
  if (_done.containsKey(key)) return _done[key] = _done.remove(key);
  TextSpan? span;
  try {
    final r = _Spans(look);
    _highlight.highlight(code: code, language: lang).render(r);
    span = TextSpan(style: base, children: r.spans);
  } catch (_) {
    // A grammar that fails on this code: plain, then.
  }
  if (_done.length >= 64) _done.remove(_done.keys.first);
  return _done[key] = span;
}

// highlight.js's scopes ("title.function", "meta"), by their first part as
// its stylesheets name them (.hljs-title), in Native's colours. A scope
// not here takes the one around it, as CSS would.
TextStyle? _style(String scope, Look look) => switch (scope.split(RegExp(r'[. ]')).first) {
      'comment' || 'quote' => TextStyle(color: look.ink3, fontStyle: FontStyle.italic),
      'keyword' || 'selector-tag' || 'built_in' || 'type' || 'doctag' => TextStyle(color: look.accent),
      'string' || 'regexp' || 'symbol' || 'char' || 'addition' => TextStyle(color: look.done),
      'number' || 'literal' => TextStyle(color: look.work),
      'title' || 'section' || 'name' || 'attr' || 'attribute' => TextStyle(color: look.accent),
      'meta' || 'variable' || 'template-variable' => TextStyle(color: look.ink2),
      'deletion' => TextStyle(color: look.block),
      _ => null,
    };

class _Spans implements HighlightRenderer {
  _Spans(this.look);
  final Look look;
  final spans = <InlineSpan>[];
  final _open = <(TextStyle?, List<InlineSpan>)>[];

  List<InlineSpan> get _into => _open.isEmpty ? spans : _open.last.$2;

  @override
  void addText(String text) => _into.add(TextSpan(text: text));

  @override
  void openNode(DataNode node) => _open.add((node.scope == null ? null : _style(node.scope!, look), []));

  @override
  void closeNode(DataNode node) {
    final (style, children) = _open.removeLast();
    _into.add(TextSpan(style: style, children: children));
  }
}
