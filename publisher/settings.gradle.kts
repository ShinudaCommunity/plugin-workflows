rootProject.name = "suvio-release-publisher"

dependencyResolutionManagement {
    repositories {
        maven {
            url = uri("https://repo.suviomedia.cc/repository/suvio-maven-public/")
            content { includeGroup("cc.suviomedia") }
        }
        mavenCentral()
    }
}
