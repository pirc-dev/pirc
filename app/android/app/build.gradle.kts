import java.util.Base64
import java.util.SortedSet
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

android {
    namespace = "dev.pirc.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.pirc.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // Android 11: a Keystore key that asks for a fingerprint, the face
        // or the PIN at each use (KeyStore.kt).
        minSdk = 30
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // The upload key Play checks each upload against (Play signs the app
    // itself), given at build time: the keystore's path, its password, and
    // the key's alias. Nothing of it is kept in the repo.
    signingConfigs {
        create("upload") {
            System.getenv("PIRC_UPLOAD_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("PIRC_UPLOAD_KEYSTORE_PASSWORD")
            keyPassword = System.getenv("PIRC_UPLOAD_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("PIRC_UPLOAD_KEY_ALIAS") ?: "upload"
            storeType = "PKCS12"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("upload")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// A release is signed with the upload key or not built: one signed with
// another key would be refused by Play, or, as the first upload, would
// become its upload key.
gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.matches(Regex("(package|sign)Release.*")) } &&
        (System.getenv("PIRC_UPLOAD_KEYSTORE") == null || System.getenv("PIRC_UPLOAD_KEYSTORE_PASSWORD") == null)
    ) {
        throw GradleException("A release build needs the upload key: set PIRC_UPLOAD_KEYSTORE and PIRC_UPLOAD_KEYSTORE_PASSWORD (and PIRC_UPLOAD_KEY_ALIAS if it is not \"upload\").")
    }
}

// The store build, the one with the paywall, is asked for with
// --dart-define=PIRC_STORE=true (lib/app/store.dart); a build from source
// has none. An app bundle, which is what goes to Google Play, says which
// it is, true or false, so that a store release that forgets it stops
// rather than go out without the paywall. Flutter gives the defines as
// base64, comma-separated.
val pircStore: String? = (project.findProperty("dart-defines") as String?)
    ?.split(",")
    ?.filter { it.isNotEmpty() }
    ?.map { String(Base64.getDecoder().decode(it)) }
    ?.lastOrNull { it.startsWith("PIRC_STORE=") }
    ?.removePrefix("PIRC_STORE=")
gradle.taskGraph.whenReady {
    if (pircStore != null && pircStore != "true" && pircStore != "false") {
        throw GradleException("PIRC_STORE is true, a store build, or false, a build from source, not \"$pircStore\".")
    }
    if (pircStore == null && allTasks.any { it.project == project && it.name == "bundleRelease" }) {
        throw GradleException("An app bundle is for Google Play: say whether it is the store build, with --dart-define=PIRC_STORE=true (with the paywall) or false (without).")
    }
}

// The notices of the Android libraries in the build, for the Licences page
// beside Flutter's NOTICES (About.kt, lib/app/notices.dart): each library's
// licence from its POM, with the full text from ../notices/, and the
// notices Google's closed libraries carry inside them
// (third_party_licenses.json). A licence it does not know fails the build.
// Release builds only, the ones that go out: debug's tree also has the test
// libraries integration_test brings.
androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        val runtime = variant.runtimeConfiguration
        val task = tasks.register<Notices>("${variant.name}Notices") {
            texts.set(layout.projectDirectory.dir("../notices"))
            val archive = Attribute.of("artifactType", String::class.java)
            for (type in listOf("aar", "jar")) {
                val view = runtime.incoming.artifactView {
                    attributes { attribute(archive, type) }
                    lenient(true)
                }
                archives.from(view.files)
                archiveIds.addAll(view.artifacts.resolvedArtifacts.map { all ->
                    all.map { "${it.id.componentIdentifier.displayName}=${it.file.name}" }
                })
            }
            poms.set(runtime.incoming.resolutionResult.rootComponent.map { root -> pomLicences(root) })
        }
        variant.sources.assets?.addGeneratedSourceDirectory(task, Notices::output)
    }
}

// Every module in the tree, with the licences its POM (or a parent's)
// names: "group:name:version" to "name\turl" lines.
fun pomLicences(root: org.gradle.api.artifacts.result.ResolvedComponentResult): Map<String, String> {
    val modules = mutableSetOf<ModuleComponentIdentifier>()
    val seen = mutableSetOf<org.gradle.api.artifacts.result.ResolvedComponentResult>()
    fun walk(c: org.gradle.api.artifacts.result.ResolvedComponentResult) {
        if (!seen.add(c)) return
        (c.id as? ModuleComponentIdentifier)?.let { modules += it }
        for (d in c.dependencies) {
            if (d is org.gradle.api.artifacts.result.ResolvedDependencyResult) walk(d.selected)
        }
    }
    walk(root)
    val pom = { group: String, module: String, version: String ->
        dependencies.createArtifactResolutionQuery()
            .forModule(group, module, version)
            .withArtifacts(MavenModule::class.java, MavenPomArtifact::class.java)
            .execute().resolvedComponents.singleOrNull()
            ?.getArtifacts(MavenPomArtifact::class.java)?.firstOrNull()
            ?.let { (it as org.gradle.api.artifacts.result.ResolvedArtifactResult).file.readText() }
    }
    fun tag(xml: String, name: String) = Regex("<$name>\\s*(.*?)\\s*</$name>", RegexOption.DOT_MATCHES_ALL).find(xml)?.groupValues?.get(1)
    // Flutter's engine is in Flutter's NOTICES. A POM-only module (a BOM,
    // or one that only points at its platform's) carries no code.
    return modules.filter { it.group != "io.flutter" }.mapNotNull { id ->
        var xml = pom(id.group, id.module, id.version)
        if (xml != null && tag(xml, "packaging") == "pom") return@mapNotNull null
        var licences = ""
        while (xml != null) {
            val block = tag(xml, "licenses")
            if (block != null) {
                licences = Regex("<license>(.*?)</license>", RegexOption.DOT_MATCHES_ALL).findAll(block)
                    .joinToString("\n") { "${tag(it.value, "name")}\t${tag(it.value, "url")}" }
                break
            }
            val parent = tag(xml, "parent") ?: break
            xml = pom(tag(parent, "groupId")!!, tag(parent, "artifactId")!!, tag(parent, "version")!!)
        }
        "${id.group}:${id.module}:${id.version}" to licences
    }.toMap()
}

abstract class Notices : DefaultTask() {
    @get:InputDirectory abstract val texts: DirectoryProperty
    @get:InputFiles abstract val archives: ConfigurableFileCollection
    @get:Input abstract val archiveIds: ListProperty<String>
    @get:Input abstract val poms: MapProperty<String, String>
    @get:OutputDirectory abstract val output: DirectoryProperty

    // A module's BSD-3-Clause part, whose copyright the POM leaves out:
    // CameraX's image code uses libyuv, and datastore carries a copy of
    // protobuf-lite.
    private val bsd = mapOf(
        "androidx.camera:camera-core" to "libyuv.txt",
        "androidx.datastore:datastore-preferences-external-protobuf" to "protobuf.txt",
    )

    @TaskAction
    fun write() {
        val dir = texts.get().asFile
        // Licence text to the packages under it, in a stable order.
        val entries = sortedMapOf<String, SortedSet<String>>()
        fun add(pkg: String, text: String) { entries.getOrPut(text.trim()) { sortedSetOf() } += pkg }
        for ((coords, licences) in poms.get()) {
            val pkg = coords.substringBeforeLast(':')
            if (licences.isBlank()) throw GradleException("notices: $coords has no licence in its POM")
            for (line in licences.lines()) {
                val (name, url) = line.split('\t')
                when {
                    url.contains("apache.org/licenses/LICENSE-2.0") -> add(pkg, dir.resolve("Apache-2.0.txt").readText())
                    url.contains("opensource.org/licenses/BSD-3-Clause") ->
                        add(pkg, dir.resolve(bsd[pkg] ?: throw GradleException("notices: $coords is BSD-3-Clause; add its copyright to ../notices/")).readText())
                    url.contains("developer.android.com/studio/terms") || url.contains("developers.google.com/ml-kit/terms") -> add(pkg, "$name\n$url")
                    else -> throw GradleException("notices: $coords has a licence this build does not know: $name $url")
                }
            }
        }
        val names = archiveIds.get().associate { it.substringAfterLast('=') to it.substringBeforeLast('=') }
        for (file in archives.files.sortedBy { it.name }) {
            ZipFile(file).use { zip ->
                // A NOTICE file, which Apache-2.0 asks to be passed on.
                for (e in zip.entries().asSequence().filter { Regex("META-INF/NOTICE[^/]*").matches(it.name) }) {
                    val pkg = names[file.name]?.substringBeforeLast(':') ?: file.name
                    add(pkg, zip.getInputStream(e).readBytes().decodeToString())
                }
                val json = zip.getEntry("third_party_licenses.json") ?: return@use
                val txt = zip.getInputStream(zip.getEntry("third_party_licenses.txt")).readBytes()
                val index = groovy.json.JsonSlurper().parse(zip.getInputStream(json)) as Map<*, *>
                for ((name, at) in index) {
                    at as Map<*, *>
                    val start = (at["start"] as Number).toInt()
                    add(name as String, txt.copyOfRange(start, start + (at["length"] as Number).toInt()).decodeToString())
                }
            }
        }
        // JSON, since the texts hold any separator a plain format would use.
        val out = output.get().asFile.apply { deleteRecursively() }.resolve("pirc").apply { mkdirs() }.resolve("android_notices.json")
        out.writeText(groovy.json.JsonOutput.toJson(entries.map { (text, pkgs) -> mapOf("packages" to pkgs.toList(), "text" to text) }))
    }
}
