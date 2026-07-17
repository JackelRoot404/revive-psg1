plugins {
    id("com.android.application")
}

android {
    namespace = "com.revivepsg1.diagnostics"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.revivepsg1.diagnostics"
        minSdk = 35
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = null
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

dependencyLocking {
    lockAllConfigurations()
}
