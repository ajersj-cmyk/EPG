plugins {
    id("com.android.application")
}

// Signing: CI and local release builds use the self-signed "arcade" key when these are set
// (GitHub secrets TVAPP_KEYSTORE_B64 / TVAPP_KEYSTORE_PASSWORD / TVAPP_KEY_PASSWORD, alias "arcade"; locally
// export TVAPP_KEYSTORE=/path/to/key.jks plus the passwords). A stable key matters: Android refuses
// to update an installed APK that was signed with a different key. Without them the release build
// falls back to the debug key so forks / PRs still produce an installable APK.
val ksPath: String? = System.getenv("TVAPP_KEYSTORE")
val ksReady = !ksPath.isNullOrBlank() && file(ksPath).exists()

val appVersionName = "1.0.0"
val appVersionCode = 1

android {
    namespace = "com.ahlers.cavetrivia"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.ahlers.cavetrivia"
        minSdk = 24
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("arcade") {
            if (ksReady) {
                storeFile = file(ksPath!!)
                storePassword = System.getenv("TVAPP_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TVAPP_KEY_ALIAS") ?: "arcade"
                keyPassword = System.getenv("TVAPP_KEY_PASSWORD") ?: System.getenv("TVAPP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (ksReady) signingConfigs.getByName("arcade") else signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // The shell is TV-first but also sideloads onto Fire TV / phones; these are intentional.
        // Single-language kiosk text; banner is xhdpi-only as Android TV expects; backup is off on purpose.
        disable += setOf("MissingLeanbackSupport", "SetTextI18n", "IconMissingDensityFolder", "DataExtractionRules")
        abortOnError = true
    }
}

base {
    archivesName.set("cave-trivia-tv-$appVersionName")
}
