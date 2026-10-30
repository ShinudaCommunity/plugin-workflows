// Standalone dependency bootstrap. This project never receives publisher credentials.
plugins { application }

java { toolchain { languageVersion.set(JavaLanguageVersion.of(25)) } }

dependencies { runtimeOnly("cc.suviomedia:plugin-publisher:1.0.0-rc.66") }

application {
    mainClass.set("cc.suviomedia.suvio.publisher.PublisherCliKt")
    applicationName = "suvio-plugin-publisher"
}
